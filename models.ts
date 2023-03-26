import { Script, OpCode, Hash } from 'bsv';

export class Origin {
    txid: Buffer = Buffer.alloc(32);
    vout: number = 0;

    toString() {
        return this.txid.toString('hex') + '_' + this.vout;
    }

    toBuffer() {
        return Buffer.concat([
            this.txid,
            Buffer.from(this.vout.toString(16).padStart(8, '0'), 'hex'),
        ]);
    }

    static fromOutpoint(txid: Buffer, vout: number) {
        const origin = new Origin();
        origin.txid = txid;
        origin.vout = vout;
        return origin;
    }
    static fromString(str: string) {
        const origin = new Origin();
        origin.txid = Buffer.from(str.slice(0, 64), 'hex');
        origin.vout = parseInt(str.slice(65), 10);
        return origin;
    }

    static fromBuffer(buf: Buffer) {
        const origin = new Origin();
        origin.txid = buf.slice(0, 32);
        origin.vout = parseInt(buf.slice(32).toString('hex'), 16);
        return origin;
    }

    toJSON() {
        return this.toString();
    }

    static fromJson(json: string) {
        const value = JSON.parse(json);
        return Origin.fromString(value);
    }
}

export class FSDir {
    origin?: Origin;
    name: string = '';
    entries: { [key: string]: string } = {};
}

export class FSEntry {
    origin: Origin = new Origin();
    name: string = '';
    data: Buffer = Buffer.alloc(0);
}

export class File {
    hash: string = '';
    size: number = 0;
    type: string = '';
}

export class InscriptionData {
    type?: string = '';
    data?: Buffer = Buffer.alloc(0);
    lock: Buffer = Buffer.alloc(32);
}

export class Inscription {
    id?: number;
    txid: string = '';
    vout: number = 0;
    file?: File;
    origin: Origin = new Origin();
    height: number = 0;
    idx: number = 0;
    lock: string = '';

    static parseOutputScript(script: Script): InscriptionData {
        let opFalse = 0;
        let opIf = 0;
        let opORD = 0;
        const lock = new Script();
        for(let [i, chunk] of script.chunks.entries()) {
            if(chunk.opCodeNum === OpCode.OP_FALSE) {
                opFalse = i;
            }
            if(chunk.opCodeNum === OpCode.OP_IF) {
                opIf = i;
            }
            if(chunk.buf?.equals(Buffer.from('ord', 'utf8'))) {
                if (opFalse === i - 2 && opIf === i - 1) {
                    opORD = i;
                    lock.chunks = script.chunks.slice(0, i - 2);
                    break;
                }
            }
            lock.chunks.push(chunk);
        }

        let insData = new InscriptionData();
        if (opORD === 0) {
            insData.lock = Hash.sha256(script.toBuffer()).reverse();
            return insData;
        }
        insData.lock = Hash.sha256(lock.toBuffer()).reverse();
        for(let i = opORD + 1; i < script.chunks.length; i+=2) {
            if (script.chunks[i].buf) break;
            switch(script.chunks[i].opCodeNum) {
                case OpCode.OP_0:
                    insData.data = script.chunks[i+1].buf;
                    break;
                case OpCode.OP_1:
                    insData.type = script.chunks[i+1].buf?.toString('utf8');
                    break;
                case OpCode.OP_ENDIF:
                    break;
            }
        }
        return insData;
    }

}