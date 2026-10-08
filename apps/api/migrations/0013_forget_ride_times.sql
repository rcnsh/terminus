-- Ride detection is gone, and with it measured ride times: nothing adds
-- rides any more and nothing reads them. The rows already kept go now
-- rather than linger. The table stays, as migrations only ever add.
DELETE FROM ride_times;
