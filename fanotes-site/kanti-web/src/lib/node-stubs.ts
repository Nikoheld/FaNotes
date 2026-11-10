// The browser bundle imports the server's schulnetz-logic.mjs for its pure helpers. These stand in
// for the three Node modules it imports; the browser never calls the helpers that use them.
const unavailable = () => { throw new Error('Not available in the browser.') }
export const gunzipSync = unavailable
export const createHash = unavailable
export const isIP = (): number => 0
export default { gunzipSync, createHash, isIP }
