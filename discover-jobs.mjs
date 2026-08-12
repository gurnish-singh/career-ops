#!/usr/bin/env node

/**
 * discover-jobs.mjs — profile-based reverse ATS discovery.
 *
 * This wrapper keeps `/career-ops scan` unchanged. It seeds a temporary
 * portals.yml from the user's profile target roles, then hands control to the
 * reverse ATS scanner (`scan-ats-full.mjs`). The temp file is ephemeral and
 * never touches the user's real portals.yml.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import os from 'os';
import yaml from 'js-yaml';
import { fileURLToPath, pathToFileURL } from 'url';

import { resolveProfileKeywords } from './providers/_profile-keywords.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SCAN_SCRIPT = join(ROOT, 'scan-ats-full.mjs');
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';
const PROFILE_PATH = process.env.CAREER_OPS_PROFILE || 'config/profile.yml';
const TEMP_PREFIX = 'career-ops-discover-jobs-';

function parseArgs(argv) {
  const args = argv.slice(2);
  const help = args.includes('--help') || args.includes('-h');
  const selfTest = args.includes('--self-test');
  const forward = args.filter((arg, idx) => {
    if (arg === '--help' || arg === '-h' || arg === '--self-test') return false;
    if (idx > 0 && (args[idx - 1] === '--help' || args[idx - 1] === '-h' || args[idx - 1] === '--self-test')) return false;
    return true;
  });
  return { help, selfTest, forward };
}

function dedupeKeywords(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function loadYamlFile(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = yaml.load(readFileSync(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    throw new Error(`could not parse ${filePath}: ${err.message}`);
  }
}

export function buildDiscoverJobsPortals(baseConfig, profileKeywords) {
  const config = baseConfig && typeof baseConfig === 'object' ? { ...baseConfig } : {};
  const existingTitle = config.title_filter && typeof config.title_filter === 'object'
    ? { ...config.title_filter }
    : {};
  const mergedPositive = dedupeKeywords([
    ...(Array.isArray(existingTitle.positive) ? existingTitle.positive : []),
    ...profileKeywords,
  ]);

  if (mergedPositive.length === 0) {
    throw new Error(
      'No profile target roles found. Fill config/profile.yml target_roles.primary or target_roles.archetypes, or add title_filter.positive to portals.yml.',
    );
  }

  config.title_filter = {
    ...existingTitle,
    positive: mergedPositive,
  };

  return config;
}

export function buildScanArgs(forwardArgs) {
  return [...forwardArgs];
}

export function writeTempPortalsFile(config) {
  const tempDir = mkdtempSync(join(os.tmpdir(), TEMP_PREFIX));
  const tempPath = join(tempDir, 'portals.yml');
  writeFileSync(tempPath, yaml.dump(config, {
    noRefs: true,
    lineWidth: -1,
    sortKeys: false,
  }), 'utf-8');
  return { tempDir, tempPath };
}

export function selfTest() {
  const merged = buildDiscoverJobsPortals(
    {
      title_filter: {
        positive: ['Senior Backend Engineer', 'backend engineer'],
        negative: ['Intern'],
      },
      location_filter: {
        block: ['Internship'],
      },
    },
    ['backend engineer', 'Staff Software Engineer', 'Senior Backend Engineer'],
  );

  const positives = merged.title_filter.positive;
  if (positives.length !== 3) {
    throw new Error(`expected 3 merged keywords, got ${positives.length}`);
  }
  if (positives[0] !== 'Senior Backend Engineer' || positives[1] !== 'backend engineer' || positives[2] !== 'Staff Software Engineer') {
    throw new Error(`unexpected merged keywords: ${JSON.stringify(positives)}`);
  }
  if (!Array.isArray(merged.location_filter?.block) || merged.location_filter.block[0] !== 'Internship') {
    throw new Error('location_filter should be preserved');
  }
  if (buildScanArgs(['--since', '7', '--dry-run']).join(' ') !== '--since 7 --dry-run') {
    throw new Error('forward args should pass through unchanged');
  }
  return true;
}

function printHelp() {
  console.log(`Usage:
  node discover-jobs.mjs [scan-ats-full flags]
  npm run discover:jobs -- [scan-ats-full flags]

Profile-based reverse ATS discovery.
This command seeds a temporary portals.yml from config/profile.yml target roles
and then runs scan-ats-full.mjs. `/career-ops scan` is unchanged.

Examples:
  node discover-jobs.mjs --dry-run
  npm run discover:jobs -- --since 7 --ats greenhouse,workday
  node discover-jobs.mjs --json --limit 50
  node discover-jobs.mjs --self-test
`);
}

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    printHelp();
    return;
  }

  if (opts.selfTest) {
    selfTest();
    console.log('discover-jobs self-test OK');
    return;
  }

  const profileKeywords = resolveProfileKeywords(PROFILE_PATH);
  const baseConfig = loadYamlFile(PORTALS_PATH);
  const seededConfig = buildDiscoverJobsPortals(baseConfig, profileKeywords);
  const { tempDir, tempPath } = writeTempPortalsFile(seededConfig);

  try {
    const child = spawnSync(process.execPath, [SCAN_SCRIPT, ...buildScanArgs(opts.forward)], {
      cwd: ROOT,
      env: {
        ...process.env,
        CAREER_OPS_PORTALS: tempPath,
      },
      stdio: 'inherit',
    });

    if (child.error) {
      throw child.error;
    }
    if (child.signal) {
      process.kill(process.pid, child.signal);
    }
    process.exit(child.status ?? 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`discover-jobs: ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
}
