// Brings @testing-library/jest-dom's matcher augmentation (toHaveAttribute,
// toHaveAccessibleName, …) into the type program so `tsc` typechecks the
// component tests. The runtime registration lives in ../vitest.setup.ts.
import '@testing-library/jest-dom/vitest';
