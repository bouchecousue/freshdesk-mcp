import { generateMasterKey } from "../src/crypto.js";

process.stdout.write(`${generateMasterKey()}\n`);
