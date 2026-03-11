/*
 * Company-wide extension defaults.
 *
 * Populate sharedAccessServiceBaseUrl before distributing the extension if you
 * want new installs to auto-bootstrap against a shared access service without
 * manual per-user setup.
 */

globalThis.MAILROOMNAV_DEPLOYMENT_DEFAULTS = Object.freeze({
  sharedAccessServiceBaseUrl: '',
});
