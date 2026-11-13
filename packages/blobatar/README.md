# @manor/blobatar

Manor's own copy of [blobatar](https://github.com/Alain00/blobatar) 2.3.1 and its React adapter `@blobatar/react` 2.3.1, by Alain, MIT licensed (see `LICENSE`). It draws every generated persona face on web and on the phone.

Vendored so the faces can be changed here instead of waiting on the npm package. The source started as a verbatim copy of the published `src/`, with these differences.

- `react.tsx` is the React component, exported as `@manor/blobatar/react`. Upstream's `@blobatar/react` only re-exported it.
- Only the entry points Manor imports are exported. Upstream's `./blob`, `./uri`, `./vue` and `./package.json` subpaths are dropped, and `vue.ts` and `blob.ts` are left out with them: Manor has no Vue, and nothing imported the renderer-only entry, the data-URI helper or the manifest. `uri.ts` stays because the React component draws its static `<img>` through it. Add a subpath back when a caller needs one.
- Consumers read the TypeScript source directly, like the other workspace packages. There is no build step, so the bundler notes in `index.ts` and `internal.ts` describe upstream's build, not this one.

## Entry points

| Import | What it is |
| --- | --- |
| `@manor/blobatar` | `blobatar()`, `palette`, `traits`, `_layout` and the rest of the public API |
| `@manor/blobatar/expression` | The poses (`unsure`, `happy`, …) |
| `@manor/blobatar/internal` | `_parts`, which the phone's native face takes apart |
| `@manor/blobatar/react` | `<Blobatar>` |
| `@manor/blobatar/motion.css` | The idle motion layer. Manor's `styles.css` targets its `.mo-*` classes |

## Changing a face

Every persona's look follows from her name, the shape, tone and hue she stores, and the pinned face traits in `@manor/client-runtime/blob-shapes`. A change to the ranges in `styles/compose.ts`, the bands in `styles/blob.ts`, the palette in `color.ts` or the poses in `expression.ts` changes existing personas everywhere at once. Try it in the avatar playground first (`pnpm --filter @manor/web dev`, then open `/playground.html`).
