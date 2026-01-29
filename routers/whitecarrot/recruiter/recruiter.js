const express = require("express");
const { z } = require("zod");

function createRecruiterRouter({ supabase, requireAuth }) {
  const router = express.Router();

  async function assertRecruiterOwnsCompany(userId, companyId) {
    const { data, error } = await supabase
      .from("recruiters")
      .select("company_id")
      .eq("id", userId)
      .maybeSingle();

    if (error) throw error;
    if (!data?.company_id) return { ok: false, reason: "not_a_recruiter" };
    if (data.company_id !== companyId) return { ok: false, reason: "wrong_company" };

    return { ok: true };
  }

  // Get company (draft allowed) for recruiter editor
  router.get("/company/:slug", requireAuth, async (req, res) => {
    const slug = req.params.slug;

    const { data: company, error } = await supabase
      .from("companies")
      .select("*")
      .eq("slug", slug)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!company) return res.status(404).json({ error: "Company not found" });

    const authz = await assertRecruiterOwnsCompany(req.user.id, company.id);
    if (!authz.ok) return res.status(403).json({ error: "Forbidden" });

    res.json({ company });
  });

  // Update theme/sections
  router.put("/company/:slug", requireAuth, async (req, res) => {
    const slug = req.params.slug;

    const bodySchema = z.object({
      theme: z.record(z.string(), z.any()).optional(),
      sections: z.array(z.any()).optional(),
      culture_video_url: z.preprocess(
        (value) => (value === "" ? null : value),
        z.string().url().nullable().optional()
      ),
    });

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { data: company, error: cErr } = await supabase
      .from("companies")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();

    if (cErr) return res.status(500).json({ error: cErr.message });
    if (!company) return res.status(404).json({ error: "Company not found" });

    const authz = await assertRecruiterOwnsCompany(req.user.id, company.id);
    if (!authz.ok) return res.status(403).json({ error: "Forbidden" });

    const { data, error } = await supabase
      .from("companies")
      .update({
        ...parsed.data,
        updated_at: new Date().toISOString(),
      })
      .eq("id", company.id)
      .select("*")
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ company: data });
  });

  // Publish company
  router.post("/company/:slug/publish", requireAuth, async (req, res) => {
    const slug = req.params.slug;

    const { data: company, error: cErr } = await supabase
      .from("companies")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();

    if (cErr) return res.status(500).json({ error: cErr.message });
    if (!company) return res.status(404).json({ error: "Company not found" });

    const authz = await assertRecruiterOwnsCompany(req.user.id, company.id);
    if (!authz.ok) return res.status(403).json({ error: "Forbidden" });

    const { data, error } = await supabase
      .from("companies")
      .update({ status: "published", updated_at: new Date().toISOString() })
      .eq("id", company.id)
      .select("*")
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ company: data });
  });


  router.post("/company/:slug/unpublish", requireAuth, async (req, res) => {
    const slug = req.params.slug;

    const { data: company, error: cErr } = await supabase
      .from("companies")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();

    if (cErr) return res.status(500).json({ error: cErr.message });
    if (!company) return res.status(404).json({ error: "Company not found" });

    const authz = await assertRecruiterOwnsCompany(req.user.id, company.id);
    if (!authz.ok) return res.status(403).json({ error: "Forbidden" });

    const { data, error } = await supabase
      .from("companies")
      .update({ status: "draft", updated_at: new Date().toISOString() })
      .eq("id", company.id)
      .select("*")
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ company: data });
  });

  return router;
}

module.exports = createRecruiterRouter;
