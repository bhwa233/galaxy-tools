# @spark233/ui

Versioned theme resources and optional React components for spark233 plugins.
Package 0.3.0 supports SDK >=0.2.0 <0.4.0, host API ^1.1.0 and theme protocol
^1.0.0; these ranges are recorded in `package.json` under `spark233Ui`.
Import `@spark233/ui/theme.css`, apply the initial SDK context theme with
`applyPluginTheme(context.theme)`, and subscribe to `client.onTheme` using the
same function. Components can use the standard shadcn semantic CSS variables.
The host uses these same bamboo accent tokens; plugins can use any framework.

Theme protocol 1.0 also supports the optional `accent` field: `green` (default),
`blue`, `purple`, `orange`, or `rose`. `applyPluginTheme` applies both appearance
and accent through root data attributes; `theme.css` supplies light/dark palettes.
Existing clients without an accent continue to use bamboo green.

React plugins can import `Button`, `Alert`, `Badge`, `Card`, `Input`, `Textarea`
and `Spinner` families from `@spark233/ui/components`, and load the precompiled
`@spark233/ui/components.css`. The installed peers are React 19, Base UI 1.9,
class-variance-authority 0.7, cn 0.5 and lucide-react 1.64. Peers are optional for
framework independent theme-only consumers; component consumers must provide
them. Component APIs and composition remain those of the existing shadcn source.

`packages/ui/src/components/` is the single component source shared by the desktop app and plugins. `node packages/ui/build.mjs`
bundles its exports and generates standalone JS, declarations and utility CSS
under `packages/ui/dist/`; `--output <directory>` assembles an independent package
in an explicit directory. Published imports and declarations do not reference
host source paths. No lifecycle scripts run when installing the built package.

The clipboard workspace imports these components through the package entry.
The renderer build records the resolved package version, compatibility and entry
source hash in `spark233-ui.json`; official plugin assembly verifies that record
and includes it under `uiPackage` in `renderer/spark233-shared-ui.json`. The
existing font v1 contract is versioned separately from this component package.

The npm scope is provisional until account ownership is verified. Build a local
archive with `pnpm pack`; publication requires explicit authorization.

## Base UI primitives (0.3)

The shared Button and Input use Base UI primitives; Badge uses Base UI useRender. React consumers provide @base-ui/react ^1.9.0. The desktop uses the shadcn Base Nova collection for dialogs, menus, checkbox, separator and toast. Theme protocol 1.x is unchanged. Command remains the official cmdk composition with a Base UI dialog.
