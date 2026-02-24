const axios = require("axios");
const fs = require("fs");

async function downloadMultiplePDFs() {
  const ids = [101, 102, 103];

  for (const id of ids) {
    try {
      const response = await axios.get(
        "http://localhost:3000/generate-by-venue?date=2026-02-23&venue=ELT-18&time=11:30:00",
        {
          params: { id },
          responseType: "arraybuffer"   // VERY IMPORTANT
        }
      );

      fs.writeFileSync(`report_${id}.pdf`, response.data);
      console.log(`Downloaded report_${id}.pdf`);
    } catch (err) {
      console.error("Error downloading", id, err.message);
    }
  }
}

downloadMultiplePDFs();