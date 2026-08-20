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
 */
export class ManifestBoundToolRegistry extends ToolRegistry {
  private readonly manifest: PluginManifest;

  private readonly target: ToolRegistry;

  private readonly trusted: boolean;

  private readonly staged = new Map<string, Tool>();

  private readonly records: PluginToolRecord[] = [];

  constructor(options: { manifest: PluginManifest; target: ToolRegistry; trusted: boolean }) {
    super();
    this.manifest = options.manifest;
    this.target = options.target;
    this.trusted = options.trusted;
  }

  override register(tool: Tool): void {
    const declared = declaredRiskFor(this.manifest, tool.name);
    if (declared === undefined) {
      throw new PluginManifestError(
        `Plugin ${this.manifest.packageName} tried to register ${tool.name}, which its manifest does not declare. `
        + 'Add it to contributes.tools, or declare the namespace it belongs to in contributes.toolsDiscovered.',
      );
    }
    if (this.staged.has(tool.name)) {
      throw new PluginManifestError(
        `Plugin ${this.manifest.packageName} registered ${tool.name} twice.`,
      );
    }

    // Three claims, and the effective risk is the riskiest of them: the
    // manifest's declaration, the floor its package is held to, and
    // whatever the object says about itself. The object can raise itself
    // and can never talk its way below what its own package declared.
    const claimed = tool.risk;
    const risk = raiseRiskTo(
      raiseRiskTo(declared, riskFloorFor(this.trusted)),
      claimed ?? 'safe',
    );

    // Prototype preserved: a tool may be a class instance or carry the
    // `runtime`/`createCommand` shape the local-command executor detects,
    // and a plain spread would quietly turn either into an object the
    // executor no longer recognises.
    const bound = Object.assign(Object.create(Object.getPrototypeOf(tool) as object), tool, { risk }) as Tool;
    this.staged.set(tool.name, bound);
    this.records.push({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      risk,
      package: this.manifest.packageName,
      trusted: this.trusted,
    });
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

  /**
   * Move this plugin's tools into the shared registry, or refuse the whole
   * plugin. A name already registered is a load-time error naming both
   * packages, never a silent overwrite — the same reason a duplicate agent
   * id refuses the roster rather than picking whichever loaded last.
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
    return [...this.records];
  }
}
