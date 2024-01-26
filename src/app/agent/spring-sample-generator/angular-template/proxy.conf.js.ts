export const source = `
const PROXY_CONFIG = {
    "/api": {
        target: "http://localhost:3000",
        secure: false,
    },
}

module.exports = PROXY_CONFIG;
`;

export default source.trim();