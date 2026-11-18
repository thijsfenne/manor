/**
 * The model name as the composer pill shows it. The provider mark beside it already
 * says GPT, so "GPT-6.2 Sol" reads "Sol 6.2": the name first, then the version. Any
 * other label, a Claude model or a GPT id with no name after its version, stays as is.
 */
export function shortModelName(label: string): string {
  const gpt = /^GPT-(\d+(?:\.\d+)*) (.+)$/.exec(label)
  return gpt === null ? label : `${gpt[2]} ${gpt[1]}`
}
