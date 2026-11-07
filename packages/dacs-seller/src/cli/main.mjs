import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { sellerDiagnostic } from '../seller-diagnostics.mjs';
import { SellerConfigError } from './config.mjs';

const EXIT_OK = 0, EXIT_REFUSED = 1, EXIT_USAGE = 2;
const MAX_REPORTED_FIELD_LENGTH = 128;
// Filesystem causes worth naming to the operator; anything else is reported generically.
const REPORTED_FILESYSTEM_CODES = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG', 'EIO'];
// The closed command table, { name: { run({ dataDirectory }), effect } }. Later cards add their commands here.
const COMMANDS = Object.freeze({});
const USAGE = 'Usage: dacs-seller <command> --data-dir <absolute canonical path>\n'
  + '       dacs-seller --help\nNo commands are available yet.\n';
const usageError = message => Object.assign(new TypeError(message), { code: 'cli_usage' });

async function canonicalDirectory(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value || value.includes('\0')) {
    throw usageError('--data-dir must be an absolute canonical path');
  }
  let canonical;
  try {
    try {
      canonical = await realpath(value);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await lstat(value); canonical = null; } // A dangling symlink is not an absent final directory.
      catch (missing) {
        if (missing.code !== 'ENOENT') throw missing;
        canonical = join(await realpath(dirname(value)), basename(value));
      }
    }
  } catch (cause) {
    throw Object.assign(new Error('data directory metadata unavailable', { cause }), { code: 'seller_data_directory_unavailable' });
  }
  if (value !== canonical) throw usageError('--data-dir must equal its real path');
  return canonical;
}

function parseSyntax(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  let command, dataDirectory;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--data-dir') {
      if (dataDirectory !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) throw usageError('--data-dir requires one path');
      dataDirectory = argv[++index];
    } else if (argument.startsWith('-')) {
      throw usageError('unknown option');
    } else if (command === undefined) {
      command = argument;
    } else {
      throw usageError('unexpected argument');
    }
  }
  if (!command || dataDirectory === undefined) throw usageError('a command and --data-dir are required');
  return { command, dataDirectory };
}

/**
 * Returns `{ command, dataDirectory }` (or `{ help: true }` for a lone --help)
 * from explicit arguments; the directory must be absolute and equal its real path.
 * Throws a `cli_usage` error for bad arguments and `seller_data_directory_unavailable`
 * (with the filesystem cause) when the directory cannot be inspected.
 */
export async function parseCliArguments(argv) {
  const parsed = parseSyntax(argv);
  return parsed.help ? parsed : { ...parsed, dataDirectory: await canonicalDirectory(parsed.dataDirectory) };
}

function refusalReport(error) {
  if (error instanceof SellerConfigError) return { code: error.code, field: error.field.slice(0, MAX_REPORTED_FIELD_LENGTH) };
  if (error.code === 'seller_data_directory_unavailable') {
    const reason = REPORTED_FILESYSTEM_CODES.includes(error.cause?.code) ? error.cause.code : 'filesystem-error';
    return { code: error.code, reason };
  }
  return sellerDiagnostic(error.code);
}

/**
 * Runs the closed command table (`commands` is for tests) and returns the exit
 * code: 0 success, 1 refusal or failed check (reported on stderr as bounded
 * JSON), 2 usage error. Unknown commands and options are refused before any file is opened.
 */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr, commands = COMMANDS } = {}) {
  try {
    const parsed = parseSyntax(argv);
    if (parsed.help) { stdout.write(USAGE); return EXIT_OK; }
    if (!Object.hasOwn(commands, parsed.command)) throw usageError('unknown command');
    await commands[parsed.command].run({ dataDirectory: await canonicalDirectory(parsed.dataDirectory) });
    return EXIT_OK;
  } catch (error) {
    if (error?.code === 'cli_usage') { stderr.write(error.message + '\n' + USAGE); return EXIT_USAGE; }
    stderr.write(JSON.stringify(refusalReport(error ?? {})) + '\n');
    return EXIT_REFUSED;
  }
}
