/*
 * Company-wide extension defaults.
 *
 * Populate sharedAccessServiceBaseUrl before distributing the extension if you
 * want new installs to auto-bootstrap against a shared access service without
 * manual per-user setup.
 */

globalThis.MAILROOMNAV_DEPLOYMENT_DEFAULTS = Object.freeze({
  sharedAccessServiceBaseUrl: 'http://172.16.10.140:4817',
  localAccessGrants: [
    {
      email: 'abby.buckley@dyad.net',
      features: [
        'practice_navigator',
        'job_panel',
        'dashboard_hover_tools',
      ],
    },
  ],
});
