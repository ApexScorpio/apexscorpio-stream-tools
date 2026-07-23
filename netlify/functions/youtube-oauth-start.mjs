import { getStore } from "@netlify/blobs";
import { withLambda } from "@netlify/aws-lambda-compat";
import handlerModule from "./handlers/youtube-oauth-start-handler.js";
import helpersModule from "./utils/oauth-helpers.js";

const { handler } = handlerModule;
const { setRuntimeGetStore } = helpersModule;

setRuntimeGetStore(getStore);

export default withLambda(handler);
