#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();
import { generateDEK, wrapDEK } from '../utils/encryption.js';

try {
  const dek = generateDEK();
  const _wrapped = wrapDEK(dek);
  console.log('KEK check: OK');
  process.exit(0);
} catch (e) {
  console.error('KEK check: FAILED', e && e.message ? e.message : e);
  process.exit(2);
}
