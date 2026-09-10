// SPDX-License-Identifier: Apache-2.0

import type { MetadataRoute } from "next";
import { LANDING_URL } from "@/lib/urls";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${LANDING_URL}/sitemap.xml`,
  };
}
