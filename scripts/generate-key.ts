import { generateSecretKey, nip19 } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';

const sk = generateSecretKey();
const hex = bytesToHex(sk);
const nsec = nip19.nsecEncode(sk);

console.log('Generated new Nostr Identity:');
console.log('-----------------------------');
console.log(`Private Key (Hex):  ${hex}`);
console.log(`Private Key (nsec): ${nsec}`);
console.log('-----------------------------');
console.log('Keep these safe! Use the nsec or hex key in your NOSTR_ACCOUNTS env var.');
