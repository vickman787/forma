import { database } from "../lib/db";
await database();
console.log("Forma schema ready.");
process.exit(0);
