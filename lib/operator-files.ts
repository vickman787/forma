import path from "node:path";
export const operatorRecordsDirectory = () =>
  path.resolve(process.env.OPERATOR_RECORD_DIRECTORY || ".forma/contracts");
