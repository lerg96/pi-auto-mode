// Entry point declared in package.json `pi.extensions`.
// Pi's TUI extension labeller strips a trailing `index.ts`/`index.js` and
// shows the parent directory name, so this root-level entry renders in Pi's
// UI as "pi-auto-mode" (the repo directory name), not "src" or
// "pi-auto-mode.ts".
export { default } from './src/index.ts'
