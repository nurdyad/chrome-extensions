// Shared in-memory UI state used by panel modules.
// This is not persisted by itself; background/storage sync is handled elsewhere.

export const state = {
    currentSelectedOdsCode: null,
    cachedPractices: {},    // Stores the list of practices loaded from background
    jobData: []             // Stores job data scraped from the dashboard
};

// --- Setter Functions ---
// These allow other files to safely update the data above

export function setCurrentSelectedOdsCode(code) {
    state.currentSelectedOdsCode = code;
}

export function setCachedPractices(data) {
    state.cachedPractices = data;
}

export function setJobData(data) {
    state.jobData = data;
}
