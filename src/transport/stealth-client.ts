import puppeteer from 'puppeteer-core';
import type { Browser, ConnectOptions, LaunchOptions } from 'puppeteer-core';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

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

let defaultStealthClient: MagicBrowsePuppeteerClient | undefined;

export function createMagicBrowseStealthPuppeteerClient(
  baseClient: MagicBrowsePuppeteerClient = puppeteer as unknown as MagicBrowsePuppeteerClient
): MagicBrowsePuppeteerClient {
  const enhancedPuppeteer = addExtra(baseClient as never) as unknown as PuppeteerExtraClient;
  const stealthPlugin = StealthPlugin() as {
    readonly enabledEvasions?: Set<string>;
  };

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
