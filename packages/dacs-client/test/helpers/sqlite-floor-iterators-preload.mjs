// Run any test file with engine-floor iterators on every Node version:
//   node --import ./test/helpers/sqlite-floor-iterators-preload.mjs --test <file>
import { useFloorIteratorsEverywhere } from './sqlite-floor-iterators.mjs';

useFloorIteratorsEverywhere();
