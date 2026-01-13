#include <glm/glm.hpp>
#include <vector>
#include <limits>

namespace FitPlane {

glm::vec3 computeCentroid(const std::vector<glm::vec3>& points) {
    glm::vec3 centroid(0.0f);
    for (const auto& p : points) centroid += p;
    return centroid / static_cast<float>(points.size());
}

glm::mat3 computeCovarianceMatrix(const std::vector<glm::vec3>& points, const glm::vec3& centroid) {
    glm::mat3 covariance(0.0f);
    for (const auto& p : points) {
        glm::vec3 d = p - centroid;
        covariance += glm::outerProduct(d, d);
    }
    return covariance / static_cast<float>(points.size());
}

void jacobiEigenDecomposition(glm::mat3& A, glm::mat3& V) {
    const float epsilon = 1e-8f;
    const int maxIterations = 50;

    V = glm::mat3(1.0f); // Identity matrix
    int iter = 0;

    while (iter++ < maxIterations) {
        // Find largest off-diagonal element
        float maxVal = 0.0f;
        int p = 0, q = 1;
        for (int i = 0; i < 3; ++i) {
            for (int j = i+1; j < 3; ++j) {
                if (glm::abs(A[i][j]) > maxVal) {
                    maxVal = glm::abs(A[i][j]);
                    p = i;
                    q = j;
                }
            }
        }

        if (maxVal < epsilon) break;

        // Compute rotation angle
        float theta = 0.5f * glm::atan(2.0f * A[p][q], A[q][q] - A[p][p]);
        float c = glm::cos(theta);
        float s = glm::sin(theta);

        // Apply Jacobi rotation
        glm::mat3 J(1.0f);
        J[p][p] = c; J[p][q] = s;
        J[q][p] = -s; J[q][q] = c;

        A = glm::transpose(J) * A * J;
        V = V * J;
    }
}

glm::vec3 computePlaneNormal(const glm::mat3& A) {
    // Find smallest eigenvalue index
    int minIdx = 0;
    float minVal = A[0][0];
    for (int i = 1; i < 3; ++i) {
        if (A[i][i] < minVal) {
            minVal = A[i][i];
            minIdx = i;
        }
    }
    return glm::normalize(A[minIdx]);
}

glm::vec3 fit(const std::vector<glm::vec3>& points) {
    if (points.size() < 3) return glm::vec3(0.0f);
    
    const glm::vec3 centroid = computeCentroid(points);
    glm::mat3 covariance = computeCovarianceMatrix(points, centroid);
    
    glm::mat3 A = covariance;
    glm::mat3 V;
    jacobiEigenDecomposition(A, V); // A becomes diagonal, V contains eigenvectors

    // Find smallest eigenvalue index from DIAGONAL OF A
    int minIdx = 0;
    float minVal = A[0][0];
    for(int i=1; i<3; ++i) {
        if(A[i][i] < minVal) {
            minVal = A[i][i];
            minIdx = i;
        }
    }
    
    // Return corresponding COLUMN from V (eigenvectors)
    return glm::normalize(V[minIdx]);
}

glm::vec3 fitPlaneNormal(const std::vector<glm::vec3>& points) {
    if(points.size() < 3) return glm::vec3(0);
    
    glm::vec3 avgNormal(0);
    const glm::vec3 center = computeCentroid(points);
    
    // Walk around centroid in star pattern
    for(size_t i=0; i<points.size(); ++i) {
        const glm::vec3& p1 = points[i] - center;
        const glm::vec3& p2 = points[(i+1)%points.size()] - center;
        avgNormal += glm::cross(p1, p2);
    }
    
    return glm::normalize(avgNormal);
}


glm::vec3 fitPlaneNormalExhaustive(const std::vector<glm::vec3>& points) {
    const float epsilon = 1e-6f;
    const int min_points = 3;
    
    if (points.size() < min_points) return glm::vec3(0.0f);

    // Phase 1: Compute centroid and validate points
    const glm::vec3 centroid = computeCentroid(points);
    std::vector<glm::vec3> centered;
    centered.reserve(points.size());
    
    for (const auto& p : points) {
        glm::vec3 offset = p - centroid;
        if (glm::length(offset) > epsilon) {
            centered.push_back(offset);
        }
    }
    
    if (centered.size() < min_points) return glm::vec3(0.0f);

    // Phase 2: Compute all possible triangle normals
    glm::vec3 normal_sum(0.0f);
    int valid_normals = 0;
    const float min_area = 1e-4f;

    for (size_t i = 0; i < centered.size(); ++i) {
        for (size_t j = i + 1; j < centered.size(); ++j) {
            for (size_t k = j + 1; k < centered.size(); ++k) {
                const glm::vec3& a = centered[i];
                const glm::vec3& b = centered[j];
                const glm::vec3& c = centered[k];
                
                // Compute triangle vectors
                const glm::vec3 ab = b - a;
                const glm::vec3 ac = c - a;
                
                // Calculate cross product and area
                const glm::vec3 cross = glm::cross(ab, ac);
                const float area = glm::length(cross);
                
                if (area < min_area) continue;

                // Compute normalized normal with orientation check
                const glm::vec3 unit_normal = cross / area;
                
                // Weight by area to prioritize larger triangles
                normal_sum += unit_normal * area;
                valid_normals++;
            }
        }
    }

    // Phase 3: Fallback strategies if no valid normals
    if (valid_normals == 0) {
        // Try pairwise combinations as fallback
        for (size_t i = 0; i < centered.size(); ++i) {
            for (size_t j = i + 1; j < centered.size(); ++j) {
                const glm::vec3 cross = glm::cross(centered[i], centered[j]);
                const float length = glm::length(cross);
                if (length > epsilon) {
                    normal_sum += cross / length;
                    valid_normals++;
                }
            }
        }
        
        if (valid_normals == 0) return glm::vec3(0.0f);
    }

    // Phase 4: Final normalization and validation
    const glm::vec3 result = glm::normalize(normal_sum);
    
    // Verify normal direction consistency
    int positive_count = 0;
    for (const auto& p : centered) {
        if (glm::dot(p, result) > 0) positive_count++;
    }
    
    const float ratio = static_cast<float>(positive_count) / centered.size();
    if (ratio < 0.3f || ratio > 0.7f) {
        return result * (ratio < 0.5f ? 1.0f : -1.0f);
    }

    return result;
}

} // namespace FitPlane
