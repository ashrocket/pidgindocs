import { editionAppleApps } from "./edition-hooks";

/** True when the bundle is a native app that this deployment binds to the platform's device topics and release channels. */
export function isAppleClientBundle(platform: string, bundle: unknown): bundle is string {
  const bundles = editionAppleApps().clientBundles as Readonly<Record<string, readonly string[] | undefined>>;
  return typeof bundle === 'string' && !!bundles[platform]?.includes(bundle);
}

export function clientBuildKey(platform: string, bundle?: string | null): string {
  return bundle ? `${platform}:${bundle}` : platform;
}
