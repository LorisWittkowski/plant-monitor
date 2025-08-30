//
//  middleware.js
//  
//
//  Created by Loris Schulz on 30.08.25.
//

import { NextResponse } from "next/server";

export function middleware(req) {
  const basicAuth = req.headers.get("authorization");

  // ENV Variablen (in Vercel Settings setzen)
  const USER = process.env.BASIC_USER || "water";
  const PASS = process.env.BASIC_PASS || "6669";

  if (basicAuth) {
    const authValue = basicAuth.split(" ")[1];
    const [user, pwd] = Buffer.from(authValue, "base64").toString().split(":");
    if (user === USER && pwd === PASS) {
      return NextResponse.next(); // Zugriff erlauben
    }
  }

  return new Response("Auth required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Secure Area"',
    },
  });
}
