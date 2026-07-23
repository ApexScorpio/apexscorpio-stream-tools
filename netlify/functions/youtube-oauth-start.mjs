import { withLambda } from "@netlify/aws-lambda-compat";
import handlerModule from "./handlers/youtube-oauth-start-handler.js";

const { handler } = handlerModule;

export default withLambda(handler);
