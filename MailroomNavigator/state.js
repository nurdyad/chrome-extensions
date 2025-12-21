// state.js

export const state = {
    currentSelectedOdsCode: null,
    cachedPractices: {},    // Stores the list of practices loaded from background
    jobData: [],            // Stores job data scraped from the dashboard
    uniquePractices: [],    // Unique list of practices found in job data
    docActive: -1,          // Navigation index for document dropdown
    practiceActive: -1,     // Navigation index for practice dropdown
    jobIdActive: -1         // Navigation index for job ID dropdown
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

export function setUniquePractices(data) { 
    state.uniquePractices = data; 
}

export function setDocActive(val) { 
    state.docActive = val; 
}

export function setPracticeActive(val) { 
    state.practiceActive = val; 
}

export function setJobIdActive(val) { 
    state.jobIdActive = val; 
}