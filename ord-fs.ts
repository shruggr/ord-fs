import { Address, Bn, KeyPair, OpCode, PrivKey, Script, Sig, Tx, TxIn } from '@ts-bitcoin/core'
import fetch from 'cross-fetch'
import * as dotenv from 'dotenv';
import * as fs from 'fs/promises';
import * as minimist from 'minimist';
import * as mime from 'mime-types';
import * as fsPath from 'path';
import { StandardToExtended } from './bitcoin-ef/standard-to-extended';
import { ArcClient } from './js-arc-client';
import { FSDir, FSEntry, Outpoint } from './models';

dotenv.config();

var argv = minimist(process.argv.slice(2));

const SATS_PER_KB = 50;
const INPUT_SIZE = 148;
const OUTPUT_SIZE = 34;
const DUST = 10;
const SPLIT_SATS = 100000;
const MAX_SPLITS = 100;
const OUTPUT_FEE = Math.ceil(OUTPUT_SIZE * SATS_PER_KB / 1000);

const { FUNDS_WIF, FILES_WIF } = process.env;
const fundsPriv = PrivKey.fromWif(FUNDS_WIF || '');
const fundsKp = KeyPair.fromPrivKey(fundsPriv);
const fundsAdd = Address.fromPrivKey(fundsPriv);
const filesPriv = PrivKey.fromWif(FILES_WIF || '');
// const filesKp = KeyPair.fromPrivKey(filesPriv);
const filesAdd = Address.fromPrivKey(filesPriv);

console.log('FUNDS', fundsAdd.toString());
console.log('FILES', filesAdd.toString());
// process.exit();
let utxos: any[] = [];

// const {TAAL} = process.env;
const arc = 'https://arc.gorillapool.io';
// const arc = 'https://api.taal.com/arc'
const arcClient = new ArcClient(arc, {
//   apiKey: TAAL,
//   bearer: TAAL,
});

async function main() {
    switch (argv._[0]) {
        case 'download':
            await download(argv._[1], argv._[2])
            break;
        case 'upload':
            await loadUtxos();
            const fse = await inscribeDir(argv._[1]);
            console.log('ORIGIN:', fse.origin.toString());
            break
        default:
            console.error("Unknown command", argv._[0]);
    }
}

async function download(origin: string, dest: string) {
    if(origin.startsWith('ord://')) {
        origin = origin.slice(6);
    }
    let resp = await fetch(`https://ordinals.gorillapool.io/api/inscriptions/origin/${origin}`);
    if(!resp.ok) {
        throw new Error(`Failed to fetch inscription: ${origin} ${resp.status} ${resp.statusText}`);
    }
    let [inscription] = await resp.json();
    // console.log('inscription', inscription);
    resp = await fetch(`https://ordinals.gorillapool.io/api/files/inscriptions/${origin}`);
    if(!resp.ok) {
        throw new Error(`Failed to fetch inscription: ${origin} ${resp.status} ${resp.statusText}`);
    }

    if(inscription.file.type == 'ord-fs/json') {
        const dir = await resp.json()
        // console.log('dir', dir);
        await downloadDir(dir, dest);
        return;
    }
    const file = await resp.blob();
    const buf = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(dest, buf);
}

async function downloadDir(dir: FSDir, dest: string) {
    try {
        await fs.mkdir(dest);
    } catch(e: any) {
        if(e.code !== 'EEXIST') {
            throw e;
        }
    }

    for(let [name, origin] of Object.entries(dir)) {        
        const destPath = fsPath.join(dest, name);
        await download(origin, destPath);
    }
}


async function loadUtxos() {
    const address = Address.fromPrivKey(fundsPriv);
    const url = `https://api.whatsonchain.com/v1/bsv/main/address/${address.toString()}/unspent`
    const resp = await fetch(url);
    utxos = await resp.json();
    // console.log("UTXOs:", utxos)
}

async function inscribeDir(path: string): Promise<FSEntry> {
    const dir = await fs.opendir(path);
    const fsDir = new FSDir();
    fsDir.name = fsPath.basename(path);
    for await (const dirent of dir) {
        let fse = new FSEntry();
        if (dirent.isDirectory()) {
            fse = await inscribeDir(`${path}/${dirent.name}`);
        } else {
            fse = await inscribeFile(path, dirent.name);
        }
        fsDir.entries[dirent.name] = fse.origin.toString();
    }

    const tx = new Tx();
    const script = createInscriptionScript(
        filesAdd.toTxOutScript(),
        Buffer.from(JSON.stringify(fsDir.entries), 'utf8'),
        "ord-fs/json"
    )
    tx.addTxOut(new Bn(1), script);
    console.log('inscribing dir', path)
    await fundAndBroadcast(tx);

    const txid = tx.hash().reverse();
    const fse = new FSEntry();
    fse.origin = Outpoint.fromOutpoint(txid, 0);
    fse.name = fsDir.name;
    fse.data = Buffer.from(JSON.stringify(fsDir));

    // console.log(JSON.stringify(fse));
    return fse;
}

async function inscribeFile(path: string, name: string) {
    const type = mime.lookup(name) || 'application/octet-stream';
    const body = await fs.readFile(fsPath.join(path, name));
    
    const tx = new Tx();
    const script = createInscriptionScript(
        filesAdd.toTxOutScript(),
        body,
        type
    );
    tx.addTxOut(new Bn(1), script);
    console.log('inscribing file', path, name)
    await fundAndBroadcast(tx);

    const txid = tx.hash().reverse();
    const fse = new FSEntry();
    fse.origin = Outpoint.fromOutpoint(txid, 0);
    fse.name = name;
    fse.data = body;

    // console.log(JSON.stringify(fse));
    return fse;
}

function createInscriptionScript(lock: Script, content: Buffer, type: string): Script {
    const script = new Script();
    script.chunks = [...lock.chunks]
    script.writeOpCode(OpCode.OP_FALSE)
        .writeOpCode(OpCode.OP_IF)
        .writeBuffer(Buffer.from("ord", "utf8"))
        .writeOpCode(OpCode.OP_1)
        .writeBuffer(Buffer.from(type, "utf8"))
        .writeOpCode(OpCode.OP_0)
        .writeBuffer(content)
        .writeOpCode(OpCode.OP_ENDIF)
    return script;
}

async function fundAndBroadcast(tx: Tx) {
    let size = tx.toBuffer().length;
    let fee = Math.ceil(size * SATS_PER_KB / 1000);
    let satsIn = 0;
    let satsOut = tx.txOuts.reduce((a, b) => a + b.valueBn.toNumber(), 0);

    const parents: { lockingScript: Buffer, satoshis: number }[] = [];
    while (satsIn < satsOut + fee) {
        const utxo = utxos.shift();
        if (!utxo) {
            throw new Error("Not enough funds");
        }
        // console.log("Adding UTXO:", utxo)
        tx.addTxIn(
            Buffer.from(utxo.tx_hash, 'hex').reverse(),
            utxo.tx_pos,
            new Script(),
            TxIn.SEQUENCE_FINAL
        );
        parents.push({
            lockingScript: fundsAdd.toTxOutScript().toBuffer(),
            satoshis: utxo.value,
        });

        satsIn += utxo.value;
        size += INPUT_SIZE;
        fee = Math.ceil(size * SATS_PER_KB / 1000);
    }
    let change = satsIn - (satsOut + fee + OUTPUT_FEE);
    let changeOutputs = 0;
    while (change > DUST) {
        if (change > SPLIT_SATS + OUTPUT_FEE && ++changeOutputs < MAX_SPLITS) {
            tx.addTxOut(new Bn(SPLIT_SATS), fundsAdd.toTxOutScript());
            satsOut += SPLIT_SATS;
            size += OUTPUT_SIZE;
            fee = Math.ceil(size * SATS_PER_KB);
            change = satsIn - (satsOut + fee);
        } else {
            size += OUTPUT_SIZE;
            fee = Math.ceil(size * SATS_PER_KB / 1000);
            change = satsIn - (satsOut + fee);
            tx.addTxOut(new Bn(change), fundsAdd.toTxOutScript());
            satsOut += change;
            change = satsIn - (satsOut + fee);
        }
    }
    for (let [vin, { lockingScript, satoshis }] of parents.entries()) {
        const sig = tx.sign(
            fundsKp,
            Sig.SIGHASH_ALL | Sig.SIGHASH_FORKID,
            vin,
            Script.fromBuffer(lockingScript),
            new Bn(satoshis)
        );
        tx.txIns[vin].setScript(new Script().writeBuffer(sig.toTxFormat()).writeBuffer(fundsKp.pubKey.toBuffer()));
    }

    const eftx = StandardToExtended(tx.toBuffer(), parents);
    const txid = tx.id()
    const result = await arcClient.postTransaction(eftx as Buffer);
    console.log('broadcasted', txid, result);
    // console.log('broadcasted', txid, tx.toHex());

    for (let [vout, txout] of tx.txOuts.entries()) {
        if(!vout) continue;
        const utxo = {
            tx_hash: txid,
            tx_pos: vout,
            value: txout.valueBn.toNumber(),
        };
        utxos.push(utxo);
        // console.log("UTXO:", utxo)
    }
}

main()
    .catch(console.error)
    .finally(() => process.exit());
