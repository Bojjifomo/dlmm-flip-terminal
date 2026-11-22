// Live activity: one line per step on stderr, prefixed "@@", that DLMM Web turns into the 📡 activity panel
// (node.py reads them while the script runs). Plain terminal runs just show them as stderr lines.
export function progress(msg, extra) {
  try { process.stderr.write("@@" + JSON.stringify({ t: Date.now(), msg: String(msg), ...(extra || {}) }) + "\n"); } catch (e) {}
}
