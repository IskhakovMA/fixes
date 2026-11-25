'use strict';

// Test precondition for the two reads under test. Keep product guards intact.
async function watch(page) {
    await page.evaluate(() => {
        const pending = new Set();
        for (const name of ['loadActivity', 'refreshInternalNotificationSummary']) {
            const original = app[name];
            app[name] = function (...args) {
                const result = Reflect.apply(original, this, args);
                pending.add(result);
                result.then(() => pending.delete(result), () => pending.delete(result));
                return result;
            };
        }
        window.workspaceBackgroundPendingForTest = () => pending.size;
    });
}

async function waitForExistingAuditedReads(page) {
    await page.evaluate(() => clearInterval(app.internalNotifications.pollTimer));
    await page.waitForFunction(() => window.workspaceBackgroundPendingForTest() === 0, null, {timeout:10000});
}

module.exports = {watch, waitForExistingAuditedReads};
