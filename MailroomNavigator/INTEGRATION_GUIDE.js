/**
 * INTEGRATION PATCH — panel.js
 * ================================
 * Add these changes to your existing panel.js to wire in auth_management.js.
 * Lines marked "ADD" are new. Lines marked "REPLACE" swap existing code.
 *
 * Step 1 ─ Add the import at the top of panel.js (alongside existing imports):
 *
 *   import { AuthManagement, AuditLog } from './auth_management.js';
 *
 *
 * Step 2 ─ Inside DOMContentLoaded, after the block that calls
 *   renderExtensionAccessState(access) and applyExtensionFeatureAccessToUi(),
 *   add the following call to bootstrap the auth management UI.
 *   A good place is right after the `if (access?.email) { ... }` block
 *   (around line 860–895 in the original panel.js):
 *
 *   // ADD: Boot auth management UI whenever the user is the owner
 *   if (extensionAccessState?.isOwner) {
 *     try {
 *       const mgmtResponse = await chrome.runtime.sendMessage({
 *         action: 'getExtensionUserManagement',
 *         payload: { forceRefresh: false }
 *       });
 *       const management = mgmtResponse?.success ? mgmtResponse.management : { users: [], featureCatalog: [] };
 *       await AuthManagement.init({
 *         accessState: extensionAccessState,
 *         management:  management,
 *         featureCatalog: extensionAccessState.featureCatalog || EXTENSION_FEATURE_CATALOG,
 *       });
 *     } catch (err) {
 *       console.warn('[Panel] AuthManagement init failed:', err);
 *     }
 *   }
 *
 *
 * Step 3 ─ Listen for events emitted by auth_management.js so panel.js
 *   can refresh its own access state reactively. Add this anywhere in
 *   DOMContentLoaded (e.g. near the bottom, with other event listeners):
 *
 *   document.addEventListener('authMgmt:userSaved', async () => {
 *     try {
 *       const freshAccess = await fetchExtensionAccessState({ forceRefresh: true });
 *       renderExtensionAccessState(freshAccess);
 *       renderAccessServiceConfig();
 *       applyExtensionFeatureAccessToUi();
 *       showView(getInitialAccessibleViewId());
 *     } catch { }
 *   });
 *
 *   document.addEventListener('authMgmt:userDeleted', async () => {
 *     try {
 *       const freshAccess = await fetchExtensionAccessState({ forceRefresh: true });
 *       renderExtensionAccessState(freshAccess);
 *       applyExtensionFeatureAccessToUi();
 *     } catch { }
 *   });
 *
 *
 * Step 4 ─ In refreshExtensionUserManagementUi (existing function around line 818),
 *   after the management state is refreshed, add a call so the new UI also
 *   re-renders when the old "Refresh List" button was clicked.
 *   REPLACE the existing function body with:
 *
 *   const refreshExtensionUserManagementUi = async ({ forceRefresh = false } = {}) => {
 *     if (!extensionAccessState?.isOwner) {
 *       extensionUserManagementState = { users: [], featureCatalog: getFeatureCatalogForUi() };
 *       return;
 *     }
 *     // Keep existing logic:
 *     const management = await fetchExtensionUserManagement({ forceRefresh });
 *     extensionUserManagementState = management;
 *     // ADD: propagate to advanced UI module
 *     await AuthManagement.refresh({ forceRefresh });
 *   };
 *
 *
 * ─── panel.html changes ───────────────────────────────────────────────────
 *
 * Step 5 ─ In <head>, add after the existing CSS links:
 *
 *   <link rel="stylesheet" href="auth_management.css">
 *
 *
 * Step 6 ─ The existing #extensionUserManagementSection div already exists in
 *   panel.html. The new module will detect it and replace its contents with the
 *   advanced UI automatically — no HTML changes required for that section.
 *
 *   However, if you want the auth panel to be accessible from a dedicated button
 *   in the Others tab, add this button alongside the existing #refreshManagedUsersBtn:
 *
 *   <button id="openAuthPanelBtn" class="btn btn-sm btn-ghost" type="button">
 *     ⚙ Manage Access
 *   </button>
 *
 *   Then in panel.js DOMContentLoaded:
 *
 *   document.getElementById('openAuthPanelBtn')?.addEventListener('click', () => {
 *     const section = document.getElementById('extensionUserManagementSection');
 *     if (section) {
 *       section.style.display = 'block';
 *       section.scrollIntoView({ behavior: 'smooth' });
 *     }
 *   });
 *
 *
 * ─── manifest.json changes ────────────────────────────────────────────────
 *
 * No changes needed. auth_management.js is a panel-side ES module that only
 * uses chrome.runtime.sendMessage and chrome.storage.local (which the panel
 * already has via the 'storage' permission).
 *
 *
 * ─── Quick verification ───────────────────────────────────────────────────
 *
 * After wiring everything in, open the panel as the owner account. You should
 * see the "Access Control" section replaced by:
 *
 *   👥 Users | 📨 Invites | 📋 Audit
 *
 * Tabs. The Users tab shows the add-user form + user cards with edit/delete.
 * Invites tab lets you generate shareable single-use tokens.
 * Audit tab records all changes with actor, timestamp, and event detail.
 */

// ─── Standalone self-test (run in DevTools console on the panel page) ─────────
//
//  import { AuthManagement } from './auth_management.js';
//  AuthManagement.init({
//    accessState: { email: 'owner@example.com', isOwner: true, featureCatalog: [] },
//    management: { users: [], featureCatalog: [] },
//    featureCatalog: [],
//  });
