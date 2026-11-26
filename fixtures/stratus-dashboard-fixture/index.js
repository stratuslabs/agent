// The contract the control API loads `@stratusagent/dashboard` by:
// `createDashboardAssets()` returning an object whose `serve(pathname,
// response)` answers true when it wrote a response. The real package is a
// single-page app, so it answers every path with its shell; so does this.
const PAGE = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Stratus Agent</title></head><body>dashboard fixture</body></html>\n';

export const createDashboardAssets = () => ({
  async serve(_pathname, response) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE);
    return true;
  },
});
