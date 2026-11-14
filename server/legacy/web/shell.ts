import type { Env } from "../types";
import { appPath, type ShellConfig, type ShellLink } from "./app-shell";

/** The shared header's brand, place row and account menu for this deployment. */
export function shell(_env: Env, opts: { base?: string; canManagePeople?: boolean } = {}): ShellConfig {
  const base = opts.base ?? "";
  const menu: ShellLink[] = [
    // The audio briefings page lives at /commute in this edition.
    { key: "audio", label: "Audio", href: appPath(base, "/commute") },
    { key: "instances", label: "Instances", href: appPath(base, "/registry") },
    { key: "stats", label: "Stats", href: appPath(base, "/stats") },
    { key: "profile", label: "Profile", href: appPath(base, "/profile") },
    { key: "setup", label: "Setup", href: appPath(base, "/setup") },
  ];
  if (opts.canManagePeople) menu.push({ key: "people", label: "People", href: appPath(base, "/admin/users") });
  return {
    brand: { name: "PidginDocs", mark: appPath(base, "/assets/app-icon.jpg") },
    places: ["workspace", "inbox", "library"],
    menu,
  };
}
