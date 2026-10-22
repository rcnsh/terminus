# Every API route is under /api; old apps get 426, everything else 308

The API and the website shared root paths, and `/pair` was both a page and an API route (dd5b8d72). Moving every API route under `/api` stops new routes and pages colliding. An old root path answers an app with 426, so a 2.x app shows "update" rather than an error, and anything else with a 308. Some paths stay at the root because they are already out in the world: the pages, `/auth/verify` and `/auth/approve` (links in emails already sent), `/download/*` (the Mac's update feed is built into every copy) and `/map/*`.
