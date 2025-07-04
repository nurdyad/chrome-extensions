function extractAndCopyJobID() {
    let rows = document.querySelectorAll("table tr");
    if (!rows || rows.length === 0) {
        alert("No Job IDs found!");
        return;
    }

    let jobData = [];
    rows.forEach(row => {
        let cells = row.querySelectorAll("td");
        if (cells.length > 2) {
            let jobType = cells[1]?.innerText.trim();
            let jobId = cells[3]?.innerText.trim();
            
            if (jobType && jobId) {
                let variableName = "";
                switch (jobType.toLowerCase()) {
                    case "emis_api":
                        variableName = "emis_api_job_id";
                        break;
                    case "emis_coding":
                        variableName = "emis_coding_job_id";
                        break;
                    case "docman_file":
                        variableName = "file_job_id";
                        break;
                    case "docman_upload":
                        variableName = "upload_job_id";
                        break;
                    case "generate_output":
                        variableName = "generate_output_job_id";
                        break;
                    default:
                        variableName = "unknown_job_id";
                }

                jobData.push(`${variableName} = "${jobId}"`);
            }
        }
    });

    if (jobData.length > 0) {
        let formattedText = jobData.join("\n");

        navigator.clipboard.writeText(formattedText).then(() => {
            alert(`Copied Job Data:\n\n${formattedText}`);
        }).catch(err => {
            console.error("Failed to copy Job ID:", err);
        });
    } else {
        alert("No valid Job IDs found.");
    }
}

extractAndCopyJobID();
