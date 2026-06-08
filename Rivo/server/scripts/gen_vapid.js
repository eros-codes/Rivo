#!/usr/bin/env node
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log(keys.publicKey);
console.log(keys.privateKey);
