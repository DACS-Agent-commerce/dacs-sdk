#!/usr/bin/env node
import { main } from '../src/cli/main.mjs';
import * as identity from '../src/cli/node-identity.mjs';
process.exitCode = await main(process.argv.slice(2), { identity });
