import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';
import type { Browser, ConnectOptions, LaunchOptions } from 'puppeteer-core';
import { addExtra } from 'puppeteer-extra';

export interface MagicBrowsePuppeteerClient {
  launch(options?: LaunchOptions): Promise<Browser>;
  connect(options: ConnectOptions): Promise<Browser>;
}

export const MAGICBROWSE_STEALTH_DISABLED_EVASIONS = [
  'iframe.contentWindow',
  'user-agent-override',
] as const;

type PuppeteerExtraClient = MagicBrowsePuppeteerClient & {
  use(plugin: unknown): unknown;
};

type StealthPluginFactory = () => {
  readonly enabledEvasions?: Set<string>;
};

const require = createRequire(import.meta.url);

function loadStealthPluginFactory(): StealthPluginFactory {
  const loaded = require('puppeteer-extra-plugin-stealth') as
    | StealthPluginFactory
    | { default?: StealthPluginFactory };
  const factory = typeof loaded === 'function' ? loaded : loaded.default;
  if (typeof factory !== 'function') {
    throw new TypeError('puppeteer-extra-plugin-stealth did not expose a plugin factory.');
  }
  return factory;
}

let defaultStealthClient: MagicBrowsePuppeteerClient | undefined;

export function createMagicBrowseStealthPuppeteerClient(
  baseClient: MagicBrowsePuppeteerClient = puppeteer as unknown as MagicBrowsePuppeteerClient,
  stealthPluginFactory: StealthPluginFactory = loadStealthPluginFactory()
): MagicBrowsePuppeteerClient {
  const enhancedPuppeteer = addExtra(baseClient as never) as unknown as PuppeteerExtraClient;
  const stealthPlugin = stealthPluginFactory();

  for (const evasion of MAGICBROWSE_STEALTH_DISABLED_EVASIONS) {
    stealthPlugin.enabledEvasions?.delete(evasion);
  }

  enhancedPuppeteer.use(stealthPlugin);

  return {
    launch: (options) => enhancedPuppeteer.launch(options),
    connect: (options) => enhancedPuppeteer.connect(options),
  };
}

export function getDefaultMagicBrowseStealthPuppeteerClient(): MagicBrowsePuppeteerClient {
  defaultStealthClient ??= createMagicBrowseStealthPuppeteerClient();
  return defaultStealthClient;
}
