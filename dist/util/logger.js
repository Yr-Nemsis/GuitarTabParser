export const log = {
    info(msg) {
        console.error(`  ${msg}`);
    },
    step(msg) {
        console.error(`\x1b[36m▶\x1b[0m ${msg}`);
    },
    success(msg) {
        console.error(`\x1b[32m✔\x1b[0m ${msg}`);
    },
    warn(msg) {
        console.error(`\x1b[33m⚠\x1b[0m ${msg}`);
    },
    error(msg) {
        console.error(`\x1b[31m✖\x1b[0m ${msg}`);
    },
    debug(msg) {
        console.error(`\x1b[90m  ${msg}\x1b[0m`);
    },
};
//# sourceMappingURL=logger.js.map