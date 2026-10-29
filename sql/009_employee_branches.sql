BEGIN;

-- Additional branches an employee works at. The primary (home) branch stays in employees.home_branch_id.
CREATE TABLE IF NOT EXISTS employee_branches (
    employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (employee_id, branch_id)
);

CREATE INDEX IF NOT EXISTS idx_employee_branches_branch ON employee_branches (branch_id);

-- Additional branches must belong to the employee's company and never duplicate the home branch.
CREATE OR REPLACE FUNCTION employee_branches_cleanup() RETURNS trigger AS $$
BEGIN
    DELETE FROM employee_branches eb USING branches b
    WHERE eb.employee_id = NEW.id AND b.id = eb.branch_id
      AND (b.company_id <> NEW.company_id OR eb.branch_id IS NOT DISTINCT FROM NEW.home_branch_id);
    RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS employee_branches_cleanup ON employees;
CREATE TRIGGER employee_branches_cleanup AFTER UPDATE OF company_id, home_branch_id ON employees
    FOR EACH ROW EXECUTE FUNCTION employee_branches_cleanup();

COMMIT;
