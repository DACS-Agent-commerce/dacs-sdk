import { completeWireEffect } from '@kynesyslabs/dacs/wire';
import { accountingFixture } from './helpers/reservation-accounting-fixture.mjs';
import { holdReleaseProbes } from './helpers/hold-release-probes.mjs';

holdReleaseProbes({ accountingFixture, completeWireEffect });
