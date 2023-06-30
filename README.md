# ord-fs
## Ordinals-based file system
This project aims to provide file system syncing with Bitcoin ordinals.

### Setup
```
npm install
npm run build
```

### Environment Variables
.env
```
FUNDS_WIF=<Funding Wallet WIF>
FILES_WIF=<Ordinal Wallet WIF>
```

### Getting Started
TAAL API Key can be acquired for free from https://console.taal.com.  
Send Funds to address associated with FUNDS_WIF.

### Directories
Directories are inscribed with a content-type of `ord-fs/json`
```
{
    <file/dir name>: <file/dir origin>,
    <file/dir name>: <file/dir origin>,
    ...
}
```

### Upload a Directory
`node dist/ord-fs.js upload <source path>`

### Download a Directory
`node dist/ord-fs.js download <origin> <dest path>`

### Sync changes between directory and ordinals
*Coming Soon*

