#ifndef SPHERICAL_WORLD_H
#define SPHERICAL_WORLD_H

#include "world.h"

class JarSphericalWorld : public JarWorld
{
    GDCLASS(JarSphericalWorld, JarWorld);

  private:
    float sphere_radius = 100.0f;

  public:
    float get_sphere_radius() const { return sphere_radius; }
    void set_sphere_radius(const float value) { sphere_radius = value; }

    Vector3 get_gravity_vector(const Vector3 &position) const override
    {
        return -(position).normalized() * get_gravity_strength();
    }

    float get_height(const Vector3 &position) const override
    {
        return (position).length() - sphere_radius;
    }

  protected:
    static void _bind_methods()
    {
        ClassDB::bind_method(D_METHOD("get_sphere_radius"), &JarSphericalWorld::get_sphere_radius);
        ClassDB::bind_method(D_METHOD("set_sphere_radius", "value"), &JarSphericalWorld::set_sphere_radius);
        ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "sphere_radius"), "set_sphere_radius", "get_sphere_radius");
    }
};

#endif // SPHERICAL_WORLD_H
