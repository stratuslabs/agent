import {
  raiseRiskTo,
  resolveToolRisk,
  ToolRegistry,
  type Tool,
  type ToolDescriptor,
  type ToolRisk,
} from '@stratusagent/core';

import { declaredRiskFor, PluginManifestError, type PluginManifest } from './manifest.ts';

/** What the daemon knows about one registered tool once a plugin is loaded. */
export interface PluginToolRecord {
  name: string;
  description?: string;
  risk: ToolRisk;
  /** The package whose code this tool is — provenance, kept for risk questions. */
  package: string;
  /** Whether that package is inside the trusted set (see the risk floor). */
  trusted: boolean;
}

/**
 * The risk floor a package's tools cannot register below.
 *
 * `safe` means "run this unattended, with nobody watching", and it is not a
 * claim the code being judged gets to make about itself. First-party
 * packages ship in this repository and are gated by its CI, so their
 * manifests are read as written; everything else floors at `gated`.
 */
export const riskFloorFor = (trusted: boolean): ToolRisk => (trusted ? 'safe' : 'gated');

/**
 * The manifest-bound view a plugin's `setup()` registers through.
 *
 * Validating package.json before importing says what a plugin *claims*; it
 * says nothing about what `setup()` then does, and `ToolRegistry.register`
 * is a bare `Map.set` that records neither the originating package nor
 * anything to check a claim against. Handed the raw registry, a plugin
 * could register a tool it never declared, mark it `safe`, and run
 * unattended — which would make the floor decoration. So this view rejects
 * a name the manifest does not declare, applies the declared risk and the
 * floor rather than trusting the object it is handed, and keeps the package
 * as provenance.
 *
 * Registrations are **staged, not committed**. A plugin that registers
 * three tools and then throws — or whose fourth name collides with another
 * package's — must not leave the first three live in a shared registry, so
 * nothing reaches the target until `commit()` says the whole plugin loaded.
 *
 * After commit the view stays the plugin's registration handle, live: a
 * bridge whose tool names arrive from somebody else's server registers what
 * it discovers on reconnect through the same gate — an undeclared name is
 * rejected exactly as it is at first load, the declared risk and any
 * operator override apply identically, and a collision with a name another
 * package owns is refused, never resolved. Only the staging changes: a
 * plugin that already loaded whole has nothing to hold back, so a live
 * registration lands in the shared registry at once.
 */
export class ManifestBoundToolRegistry extends ToolRegistry {
  private readonly manifest: PluginManifest;

  private readonly target: ToolRegistry;

  private readonly trusted: boolean;

  /**
   * The operator's per-tool risk word, from the trusted config's
   * `toolRisks` block. An override *replaces* the manifest's declaration —
   * both directions, which is its whole point: a namespace declared `gated`
   * is a ceiling on what discovery may claim, and the operator who has read
   * the server is the one party entitled to lower a tool below it. The
   * untrusted-package floor still applies on top: config can vouch for a
   * tool, not for the code that implements it.
   */
  private readonly overrides: ReadonlyMap<string, ToolRisk>;

  private readonly staged = new Map<string, Tool>();

  private readonly records: PluginToolRecord[] = [];

  private owners: Map<string, string> | undefined;

  constructor(options: {
    manifest: PluginManifest;
    target: ToolRegistry;
    trusted: boolean;
    riskOverrides?: ReadonlyMap<string, ToolRisk>;
  }) {
    super();
    this.manifest = options.manifest;
    this.target = options.target;
    this.trusted = options.trusted;
    this.overrides = options.riskOverrides ?? new Map();
  }

  override register(tool: Tool): void {
    const declared = declaredRiskFor(this.manifest, tool.name);
    if (declared === undefined) {
      throw new PluginManifestError(
        `Plugin ${this.manifest.packageName} tried to register ${tool.name}, which its manifest does not declare. `
        + 'Add it to contributes.tools, or declare the namespace it belongs to in contributes.toolsDiscovered.',
      );
    }
    this.assertUnclaimed(tool.name);

    // Three claims, and the effective risk is the riskiest of them: the
    // manifest's declaration, the floor its package is held to, and
    // whatever the object says about itself. The object can raise itself
    // and can never talk its way below what its own package declared. An
    // operator override pre-empts the first and third — it is the
    // operator's word, given in trusted config, not the plugin's — and
    // only the floor still binds it.
    const override = this.overrides.get(tool.name);
    const claimed = tool.risk;
    const risk = override !== undefined
      ? raiseRiskTo(override, riskFloorFor(this.trusted))
      : raiseRiskTo(
        raiseRiskTo(declared, riskFloorFor(this.trusted)),
        claimed ?? 'safe',
      );

    // Prototype preserved: a tool may be a class instance or carry the
    // `runtime`/`createCommand` shape the local-command executor detects,
    // and a plain spread would quietly turn either into an object the
    // executor no longer recognises.
    const bound = Object.assign(Object.create(Object.getPrototypeOf(tool) as object), tool, { risk }) as Tool;
    if (this.owners) {
      // Committed: this plugin already loaded whole, so there is nothing
      // to stage against — the registration is live, under the same gate.
      this.target.register(bound);
      this.owners.set(tool.name, this.manifest.packageName);
    } else {
      this.staged.set(tool.name, bound);
    }
    this.records.push({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      risk,
      package: this.manifest.packageName,
      trusted: this.trusted,
    });
  }

  /**
   * Forget one of **this plugin's own** tools — the removal half of live
   * discovery, for a bridge whose server stops advertising a name. A name
   * another package owns (or the kernel's) reports false and stays exactly
   * where it is: a plugin's view never reaches outside itself, on the way
   * out any more than on the way in.
   */
  override unregister(name: string): boolean {
    if (this.owners) {
      if (this.owners.get(name) !== this.manifest.packageName) {
        return false;
      }
      this.owners.delete(name);
      this.target.unregister(name);
    } else if (!this.staged.delete(name)) {
      return false;
    }
    const index = this.records.findIndex((record) => record.name === name);
    if (index >= 0) {
      this.records.splice(index, 1);
    }
    return true;
  }

  /** Reads see the whole registry: a plugin composing on another's tool is not the boundary here. */
  override get(name: string): Tool | undefined {
    return this.staged.get(name) ?? this.target.get(name);
  }

  override list(): Tool[] {
    return [...this.target.list(), ...this.staged.values()];
  }

  override describe(): ToolDescriptor[] {
    return this.list().map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.parameters ? { parameters: tool.parameters } : {}),
      risk: resolveToolRisk(tool),
    }));
  }

  private assertUnclaimed(name: string): void {
    const owner = this.owners?.get(name);
    if (owner === this.manifest.packageName || this.staged.has(name)) {
      throw new PluginManifestError(
        `Plugin ${this.manifest.packageName} registered ${name} twice.`,
      );
    }
    if (owner !== undefined) {
      throw new PluginManifestError(
        `Tool name collision: ${name} is contributed by both ${owner} and ${this.manifest.packageName}. `
        + 'Disable one of them; a tool name is unique per install.',
      );
    }
    if (this.owners && this.target.get(name)) {
      throw new PluginManifestError(
        `Tool name collision: ${name} is already registered by the kernel. `
        + `Plugin ${this.manifest.packageName} cannot replace it.`,
      );
    }
  }

  /**
   * Move this plugin's tools into the shared registry, or refuse the whole
   * plugin. A name already registered is a load-time error naming both
   * packages, never a silent overwrite — the same reason a duplicate agent
   * id refuses the roster rather than picking whichever loaded last.
   *
   * Returns the plugin's tool records **live**: the same array later
   * registrations append to and removals splice from, so a host holding it
   * always reads the current contribution rather than a snapshot that went
   * stale at the first reconnect.
   */
  commit(owners: Map<string, string>): PluginToolRecord[] {
    for (const name of this.staged.keys()) {
      const existing = owners.get(name);
      if (existing !== undefined) {
        throw new PluginManifestError(
          `Tool name collision: ${name} is contributed by both ${existing} and ${this.manifest.packageName}. `
          + 'Disable one of them; a tool name is unique per install.',
        );
      }
      if (this.target.get(name)) {
        throw new PluginManifestError(
          `Tool name collision: ${name} is already registered by the kernel. `
          + `Plugin ${this.manifest.packageName} cannot replace it.`,
        );
      }
    }
    for (const [name, tool] of this.staged) {
      this.target.register(tool);
      owners.set(name, this.manifest.packageName);
    }
    this.staged.clear();
    this.owners = owners;
    return this.records;
  }
}
