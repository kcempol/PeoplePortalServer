import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResumeScoreRing } from "./resume-score-ring";

describe("ResumeScoreRing", () => {
    it("distinguishes initial loading from a missing score", () => {
        const { rerender } = render(<ResumeScoreRing role="Developer" loading />);
        expect(screen.getByRole("img", { name: /Scoring in progress/ })).toHaveTextContent("…");
        rerender(<ResumeScoreRing role="Developer" />);
        expect(screen.getByRole("img", { name: /Score unavailable/ })).toHaveTextContent("—");
    });

    it.each([0, 34, 71, 88, 100])("displays a completed score of %s, including zero", score => {
        render(<ResumeScoreRing role="Software engineer" status="scored" score={score} />);
        expect(screen.getByRole("img", { name: `Software engineer resume match: ${score} out of 100` }))
            .toHaveTextContent(String(score));
    });

    it.each(["queued", "processing"] as const)("shows progress for %s without displaying an old score", status => {
        render(<ResumeScoreRing role="Developer" status={status} score={88} />);
        expect(screen.getByRole("img", { name: /Scoring in progress/ })).not.toHaveTextContent("88");
    });

    it.each(["failed", "stale"] as const)("does not display a %s score as current", status => {
        render(<ResumeScoreRing role="Developer" status={status} score={88} />);
        expect(screen.getByRole("img")).toHaveTextContent("—");
        expect(screen.getByRole("img")).not.toHaveAccessibleName(/88 out of 100/);
    });

    it.each([undefined, NaN, -1, 101])("does not present invalid or absent scores (%s) as zero", score => {
        render(<ResumeScoreRing role="Developer" status="scored" score={score} />);
        expect(screen.getByRole("img", { name: /Score unavailable/ })).toHaveTextContent("—");
    });

    it("hides a previously loaded number after a request fails", () => {
        const { rerender } = render(<ResumeScoreRing role="Developer" status="scored" score={88} />);
        rerender(<ResumeScoreRing role="Developer" status="scored" score={88} error />);
        expect(screen.getByRole("img", { name: /Score unavailable/ })).not.toHaveTextContent("88");
    });
});
