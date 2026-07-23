import { withLambda } from "@netlify/aws-lambda-compat";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { handler: lambdaHandler } = require("./handlers/youtube-oauth-callback-handler.js");

export default withLambda(async (event, context) => {
  return lambdaHandler(event, context);
});