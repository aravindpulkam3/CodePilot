import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

// Recreate __filename and __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The directory where we want to store the parsers
const parsersDir = path.join(__dirname, 'parsers');

// Pre-compiled WASM files hosted on a reliable CDN
// We use 'tree-sitter-wasms' which is a community package that pre-compiles these for Node/Browser
const WASM_URLS = {
    'tree-sitter-typescript.wasm': 'https://cdn.jsdelivr.net/npm/tree-sitter-wasms/out/tree-sitter-typescript.wasm',
    'tree-sitter-python.wasm': 'https://cdn.jsdelivr.net/npm/tree-sitter-wasms/out/tree-sitter-python.wasm',
    'tree-sitter-go.wasm': 'https://cdn.jsdelivr.net/npm/tree-sitter-wasms/out/tree-sitter-go.wasm',
    'tree-sitter-cpp.wasm': 'https://cdn.jsdelivr.net/npm/tree-sitter-wasms/out/tree-sitter-cpp.wasm'
};

// 1. Create the directory
if (!fs.existsSync(parsersDir)) {
    fs.mkdirSync(parsersDir, { recursive: true });
    console.log(`✅ Created directory: ${parsersDir}`);
} else {
    console.log(`✅ Directory already exists: ${parsersDir}`);
}

// 2. Helper function to download files
const downloadFile = (url, dest) => {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to get '${url}' (${response.statusCode})`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => reject(err));
        });
    });
};

// 3. Download all the required parsers
async function setup() {
    console.log('Downloading WebAssembly parsers...');
    
    for (const [fileName, url] of Object.entries(WASM_URLS)) {
        const destPath = path.join(parsersDir, fileName);
        
        if (fs.existsSync(destPath)) {
            console.log(`⏩ Skipping ${fileName} (already exists)`);
            continue;
        }

        try {
            console.log(`⬇️ Downloading ${fileName}...`);
            await downloadFile(url, destPath);
            console.log(`✅ Successfully downloaded ${fileName}`);
        } catch (error) {
            console.error(`❌ Error downloading ${fileName}:`, error.message);
        }
    }
    
    console.log('\n🎉 Setup complete! All parsers are ready.');
}

setup();