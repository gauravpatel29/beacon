// const axios = require("axios");

// /**
//  * Forward a JSON payload to Python FastAPI and return the response.
//  */
// async function proxyToPython(pythonUrl, path, payload) {
//   const url = `${pythonUrl}${path}`;
//   const response = await axios.post(url, payload, {
//     headers: { "Content-Type": "application/json" },
//     maxContentLength: Infinity,
//     maxBodyLength: Infinity,
//     timeout: 120000,
//   });
//   return response.data;
// }

// /**
//  * Forward a GET request to Python FastAPI.
//  */
// async function proxyGetToPython(pythonUrl, path) {
//   const url = `${pythonUrl}${path}`;
//   const response = await axios.get(url, { timeout: 30000 });
//   return response.data;
// }

// module.exports = { proxyToPython, proxyGetToPython };


const axios = require("axios");
const FormData = require("form-data");

/**
 * Forward a JSON payload to Python FastAPI and return the response.
 */
async function proxyToPython(pythonUrl, path, payload) {
  const url = `${pythonUrl}${path}`;

  const response = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 120000,
  });

  return response.data;
}

/**
 * Forward uploaded files to Python FastAPI as multipart/form-data.
 */
async function proxyFilesToPython(pythonUrl, path, files) {
  const url = `${pythonUrl}${path}`;

  const form = new FormData();

  for (const file of files) {
    form.append("files", file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype || "text/csv",
    });
  }

  const response = await axios.post(url, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 120000,
  });

  return response.data;
}

/**
 * Forward a GET request to Python FastAPI.
 */
async function proxyGetToPython(pythonUrl, path) {
  const url = `${pythonUrl}${path}`;

  const response = await axios.get(url, {
    timeout: 30000,
  });

  return response.data;
}

module.exports = {
  proxyToPython,
  proxyFilesToPython,
  proxyGetToPython,
};