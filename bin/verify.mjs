#!/usr/bin/env node
import { run } from '../src/run.mjs';

const { code, text } = await run(process.argv.slice(2));
if (text) console.log(text);
process.exit(code);
