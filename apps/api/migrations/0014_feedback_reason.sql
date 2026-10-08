-- The chip picked on "What was wrong?" (never-came, times-off, wrong-stop,
-- walk-longer, wrong-class), so a report can be a tap without a note. NULL
-- for feedback and for reports sent before it. note stays NOT NULL: a report
-- with only a reason keeps an empty one.
ALTER TABLE feedback ADD COLUMN reason TEXT;
