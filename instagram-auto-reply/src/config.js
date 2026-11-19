import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// O PowerShell 5.1 grava arquivos com BOM (caractere invisível no início); removemos antes de ler.
export const readText = (file) => fs.readFileSync(file, 'utf8').replace(/^﻿/, '');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const [key, value] of Object.entries(dotenv.parse(readText(envFile)))) {
    process.env[key] ??= value;
  }
}

// Acentos/emojis lidos com a codificação errada viram "Ã¡", "ðŸ’™", "â€”"...
const MOJIBAKE = /Ã[ -¿]|ðŸ|â€/;

export const PATHS = {
  profile: path.join(ROOT, 'browser-profile'),
  data: path.join(ROOT, 'data', 'replied.json'),
  logs: path.join(ROOT, 'logs'),
  screenshots: path.join(ROOT, 'screenshots'),
  config: path.join(ROOT, 'config.json'),
  profiles: path.join(ROOT, 'profiles.json'),
};

const USERNAME_RE = /^[a-z0-9._]{1,30}$/;

function bool(value, fallback) {
  if (value === undefined || value.trim() === '') return fallback;
  return /^(1|true|yes|sim)$/i.test(value.trim());
}

function int(value, fallback, name, min = 1) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`config.json: "${name}" deve ser um inteiro >= ${min}.`);
  }
  return value;
}

function range(value, name) {
  const ok = Array.isArray(value) && value.length === 2
    && value.every((n) => typeof n === 'number' && n >= 0) && value[0] <= value[1];
  if (!ok) throw new Error(`config.json: "${name}" deve ser [min, max].`);
  return value;
}

function limit(value, fallback, name) {
  return value === false ? Infinity : int(value, fallback, name);
}

export function envSettings(argv = process.argv.slice(2)) {
  const modeFlag = argv.indexOf('--browser-mode');
  const browserMode = modeFlag >= 0 ? argv[modeFlag + 1] : undefined;
  if (modeFlag >= 0 && !['desktop', 'mobile', 'iphone'].includes(browserMode)) {
    throw new Error('--browser-mode deve ser desktop, mobile ou iphone.');
  }
  const reserve = argv.includes('--reserve');
  const secondaryAccount = argv.includes('--secondary-account');
  const thirdAccount = argv.includes('--third-account');
  const fourthAccount = argv.includes('--fourth-account');
  const accountNumber = fourthAccount ? 4 : thirdAccount ? 3 : secondaryAccount ? 2 : 1;
  const primaryProfilePrefix = process.env.IG_PRIMARY_PROFILE_PREFIX;
  if (primaryProfilePrefix && !/^browser-profile-[a-z0-9._-]+$/.test(primaryProfilePrefix)) {
    throw new Error('IG_PRIMARY_PROFILE_PREFIX deve ser um nome de perfil browser-profile- válido.');
  }
  const usernameKey = fourthAccount ? 'IG_FOURTH_USERNAME' : thirdAccount ? 'IG_THIRD_USERNAME' : secondaryAccount ? 'IG_SECOND_USERNAME'
    : reserve ? 'IG_RESERVE_USERNAME' : 'IG_USERNAME';
  const instanceFlag = argv.indexOf('--instance');
  const instance = instanceFlag >= 0 ? argv[instanceFlag + 1] : null;
  const singleWorker = argv.includes('--single-worker');
  if (instanceFlag >= 0 && !/^(cazetv|tntsportsbr|geglobo|espnbrasil|sportv)-[12]$/.test(instance || '')) {
    throw new Error('--instance deve indicar uma janela válida de cazetv, tntsportsbr, geglobo, espnbrasil ou sportv (sufixo -1 ou -2).');
  }
  if (instance && reserve) throw new Error('--instance e --reserve não podem ser combinados.');
  if (secondaryAccount && reserve) throw new Error('--secondary-account e --reserve não podem ser combinados.');
  if (thirdAccount && (secondaryAccount || reserve)) throw new Error('--third-account não pode ser combinado com --secondary-account ou --reserve.');
  if (fourthAccount && (thirdAccount || secondaryAccount || reserve)) throw new Error('--fourth-account não pode ser combinado com outra conta.');
  const username = (fourthAccount ? process.env.IG_FOURTH_USERNAME || '' : thirdAccount ? process.env.IG_THIRD_USERNAME || '' : secondaryAccount ? process.env.IG_SECOND_USERNAME || ''
    : reserve ? process.env.IG_RESERVE_USERNAME || process.env.IG_USERNAME || '' : process.env.IG_USERNAME || '')
    .trim().replace(/^@/, '').toLowerCase();
  if (username && !USERNAME_RE.test(username)) throw new Error('Usuário da conta inválido no .env.');
  return {
    secondaryAccount,
    thirdAccount,
    fourthAccount,
    accountNumber,
    usernameKey,
    managedPair: argv.includes('--managed-pair'),
    accountFailover: argv.includes('--instance-account-failover'),
    sessionFromParent: argv.includes('--session-from-parent'),
    syncBrowserModes: argv.includes('--sync-browser-modes'),
    mobileFallback: argv.includes('--mobile-fallback'),
    browserMode,
    instance,
    noActionDelays: argv.includes('--no-action-delays'),
    fastNavigation: argv.includes('--fast-navigation'),
    targetProfile: instance ? instance.slice(0, -2) : null,
    shardIndex: instance && !singleWorker ? Number(instance.slice(-1)) - 1 : 0,
    shardCount: instance && !singleWorker ? 2 : 1,
    username,
    profilePath: primaryProfilePrefix && accountNumber === 1 && !reserve
      ? path.join(ROOT, `${primaryProfilePrefix}-${instance || 'manual'}`)
      : fourthAccount ? path.join(ROOT, `browser-profile-account4-${instance || 'manual'}`)
      : thirdAccount ? path.join(ROOT, `browser-profile-account3-${instance || 'manual'}`)
      : secondaryAccount ? path.join(ROOT, `browser-profile-account2-${instance || 'manual'}`)
      : instance ? path.join(ROOT, `browser-profile-${instance}`)
      : reserve ? path.join(ROOT, 'browser-profile-reserva') : PATHS.profile,
    dataPath: argv.includes('--shared-history') ? PATHS.data
      : (secondaryAccount || thirdAccount || fourthAccount) ? path.join(ROOT, 'data', `replied-${username || `account${accountNumber}`}.json`)
      : reserve ? path.join(ROOT, 'data', 'replied-reserva.json') : PATHS.data,
    dryRun: argv.includes('--dry-run') || bool(process.env.DRY_RUN, false),
    headless: bool(process.env.HEADLESS, false),
  };
}

export function loadConfig(argv) {
  const env = envSettings(argv);
  if (!env.username) throw new Error(`Defina ${env.usernameKey} no arquivo .env.`);

  if (!fs.existsSync(PATHS.config)) {
    throw new Error('config.json não encontrado. Copie config.example.json para config.json e edite.');
  }
  let raw;
  try {
    raw = JSON.parse(readText(PATHS.config));
  } catch (err) {
    throw new Error(`config.json inválido: ${err.message}`);
  }

  const activeHours = range(raw.activeHours ?? [0, 24], 'activeHours');
  if (activeHours[1] > 24 || activeHours[0] >= activeHours[1]) {
    throw new Error('config.json: "activeHours" deve ser [início, fim] em horas, ex.: [9, 23].');
  }
  const maxCommentAgeMin = raw.maxCommentAgeMin ?? 0;
  if (typeof maxCommentAgeMin !== 'number' || maxCommentAgeMin < 0) {
    throw new Error('config.json: "maxCommentAgeMin" deve ser um número de minutos (0 = sem filtro).');
  }

  const delays = raw.delays ?? {};
  const quietHours = raw.quietHours === false ? false : range(raw.quietHours ?? [3, 7], 'quietHours');
  if (quietHours !== false && (quietHours[1] > 24 || quietHours[0] >= quietHours[1])) {
    throw new Error('config.json: "quietHours" deve conter inicio e fim distintos entre 0 e 24.');
  }
  const likeProbability = raw.likeProbability ?? 0.3;
  if (typeof likeProbability !== 'number' || !Number.isFinite(likeProbability)
    || likeProbability < 0 || likeProbability > 1) {
    throw new Error('config.json: "likeProbability" deve ser um numero entre 0 e 1.');
  }
  const browserMode = env.browserMode ?? raw.browserMode ?? 'mobile';
  if (!['desktop', 'mobile', 'iphone'].includes(browserMode)) throw new Error('browserMode deve ser desktop, mobile ou iphone.');
  // O destino pode mudar sem renomear perfis de navegador ou perder sessões salvas.
  const configuredTargets = env.targetProfile ? raw.instanceTargets?.[env.targetProfile] ?? env.targetProfile : null;
  const targetProfiles = configuredTargets === null ? null
    : Array.isArray(configuredTargets) ? configuredTargets : [configuredTargets];
  if (targetProfiles && (!targetProfiles.length
    || targetProfiles.some(target => typeof target !== 'string' || !USERNAME_RE.test(target))
    || new Set(targetProfiles).size !== targetProfiles.length)) {
    throw new Error('config.json: destinos inválidos ou repetidos em instanceTargets.');
  }
  const cfg = {
    ...env,
    zeroActionDelays: Array.isArray(raw.zeroActionDelaysFor) && raw.zeroActionDelaysFor.includes(env.username),
    targetProfile: targetProfiles?.[0] ?? null,
    targetProfiles,
    browserMode,
    messages: parseMessages(raw.messages, 'config.json: "messages"'),
    messageBank: raw.messageBank?.enabled === true ? {
      file: path.join(ROOT, 'data', 'messages.sqlite'),
      templatesFile: path.resolve(ROOT, raw.messageBank.templatesFile ?? 'message-templates.json'),
    } : null,
    mentionUser: raw.mentionUser ?? true,
    likeProbability,
    postsToCheck: int(raw.postsToCheck, 5, 'postsToCheck'),
    minPostComments: int(raw.minPostComments, 30, 'minPostComments', 0),
    skipPinned: raw.skipPinned ?? false,
    maxLoadMore: int(raw.maxLoadMore, 5, 'maxLoadMore', 0),
    loadAllComments: raw.loadAllComments === true,
    ignoreEmojiOnly: raw.ignoreEmojiOnly ?? true,
    activeHours,
    quietHours,
    maxCommentAgeMin,
    limits: {
      maxPerRun: limit(raw.limits?.maxPerRun, 10, 'limits.maxPerRun'),
      maxPerDay: limit(raw.limits?.maxPerDay, 20, 'limits.maxPerDay'),
    },
    delays: {
      betweenRepliesSec: range(delays.betweenRepliesSec ?? [20, 60], 'delays.betweenRepliesSec'),
      betweenPostsSec: range(delays.betweenPostsSec ?? [5, 15], 'delays.betweenPostsSec'),
      typingMsPerChar: range(delays.typingMsPerChar ?? [40, 160], 'delays.typingMsPerChar'),
      beforeClickMs: range(delays.beforeClickMs ?? [0, 0], 'delays.beforeClickMs'),
    },
    watch: {
      intervalMin: range(raw.watch?.intervalMin ?? [15, 30], 'watch.intervalMin'),
      workSessionMin: limit(raw.watch?.workSessionMin, 20, 'watch.workSessionMin'),
      breakMin: range(
        raw.watch?.breakMin === undefined ? [4, 10]
          : typeof raw.watch.breakMin === 'number'
            ? [int(raw.watch.breakMin, 5, 'watch.breakMin'), raw.watch.breakMin]
            : raw.watch.breakMin,
        'watch.breakMin',
      ),
    },
  };
  if (cfg.noActionDelays) {
    // A opção acelera a navegação, mas nunca remove a pausa entre mensagens.
    cfg.delays = { ...cfg.delays, betweenPostsSec: [0, 0] };
  }
  // Sobrescrita temporária herdada apenas pelos filhos do inicializador desta execução.
  if (process.env.IG_RUN_ZERO_DELAYS === 'true' || cfg.zeroActionDelays) {
    cfg.delays = { betweenRepliesSec: [0, 0], betweenPostsSec: [0, 0],
      typingMsPerChar: [0, 0], beforeClickMs: [0, 0] };
    cfg.watch.intervalMin = [0, 0];
  }
  cfg.profiles = loadProfiles(cfg);
  if (cfg.targetProfile) {
    const inactive = cfg.targetProfiles.find(target => !cfg.profiles.some(profile => profile.username === target));
    if (inactive) throw new Error(`Perfil @${inactive} não está ativo em profiles.json.`);
    cfg.profiles = cfg.targetProfiles.map(target => cfg.profiles.find(profile => profile.username === target));
    cfg.profiles = cfg.profiles.map((p) => ({ ...p,
      maxPerRun: cfg.shardCount === 1 ? p.maxPerRun : Number.isFinite(p.maxPerRun)
        ? Math.floor(p.maxPerRun / 2) + (cfg.shardIndex === 0 ? p.maxPerRun % 2 : 0) : Infinity,
    }));
  }
  return cfg;
}

function parseMessages(value, name) {
  const messages = Array.isArray(value) ? value.map((m) => String(m).trim()).filter(Boolean) : [];
  if (messages.length < 1) throw new Error(`${name} deve ter pelo menos uma variação.`);
  const broken = messages.find((m) => MOJIBAKE.test(m));
  if (broken) throw new Error(`${name} tem acentos/emojis corrompidos ("${broken}"). Corrija a codificação do arquivo.`);
  return messages;
}

/**
 * Lê profiles.json: a lista de perfis cujos posts terão os comentários respondidos.
 * Sem o arquivo, usa só o perfil da conta logada (IG_USERNAME).
 * Cada perfil pode sobrescrever messages, postsToCheck, skipPinned e maxPerRun.
 */
function loadProfiles(cfg) {
  const defaults = (username) => ({
    username,
    messages: cfg.messages,
    postsToCheck: cfg.postsToCheck,
    skipPinned: cfg.skipPinned,
    maxPerRun: cfg.limits.maxPerRun,
  });
  if (!fs.existsSync(PATHS.profiles)) return [defaults(cfg.username)];

  let raw;
  try {
    raw = JSON.parse(readText(PATHS.profiles));
  } catch (err) {
    throw new Error(`profiles.json inválido: ${err.message}`);
  }
  if (!Array.isArray(raw.profiles)) throw new Error('profiles.json: falta a lista "profiles".');

  const seen = new Set();
  const profiles = [];
  for (const [i, p] of raw.profiles.entries()) {
    const where = `profiles.json: perfil #${i + 1}`;
    const username = String(p.username ?? '').trim().replace(/^@/, '').toLowerCase();
    if (!USERNAME_RE.test(username)) throw new Error(`${where}: "username" inválido.`);
    if (seen.has(username)) throw new Error(`${where}: @${username} aparece mais de uma vez.`);
    seen.add(username);
    if (p.enabled === false) continue;
    const base = defaults(username);
    profiles.push({
      ...base,
      messages: p.messages === undefined ? base.messages : parseMessages(p.messages, `${where} (@${username}): "messages"`),
      postsToCheck: int(p.postsToCheck, base.postsToCheck, `${where}: postsToCheck`),
      skipPinned: p.skipPinned ?? base.skipPinned,
      maxPerRun: limit(p.maxPerRun, base.maxPerRun, `${where}: maxPerRun`),
    });
  }
  if (!profiles.length) throw new Error('profiles.json: nenhum perfil ativo ("enabled": true).');
  return profiles;
}
