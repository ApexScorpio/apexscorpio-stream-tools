import { withLambda } from "@netlify/aws-lambda-compat";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { handler } = require("./handlers/youtube-oauth-start-handler.js");

export default withLambda(handler);
